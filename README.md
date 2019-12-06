# zabbix-grafana  
`
git clone https://github.com/zhangyudd/zabbix-grafana.git  

chmod 777 grafana/grafana.db   
docker-compose up -d   
`
>Zabbix  
>>	登录ip:10052，帐号为Admin，密码为zabbix  

>如果zabbix图形有乱码：  
>>	docker cp simhei.ttf zabbix-server:/usr/share/zabbix/fonts/DejaVuSans.ttf   

>zabbix导入端口自动发现配置文件：  
>>	port_discovery_templates.xml  

>Grafana：  
>>	web ip:3000，默认帐号admin/admin  

>Grafana添加数据源(zabbix_mysql,zabbix)：  
>>	zabbix_mysql  
>>>		db:3306  
>>>		Database:zabbix  
>>>		User:root  
>>>		Password:  
>>	zabbix  
>>>		URL：http://web/api_jsonrpc.php  
>>>		Zabbix API details：Admin/zabbix Trends:开启 Direct DB Connection：开启 Alerting：开启  

>添加dashboard：  
>>  导入文件：Zabbix template-1575445528320.json  
>或者新建：   
>>  Variables:  
>>  group			*  
>>  host			$group.*  
>>  application	$group.$host.*  
>>  iteams			$group.$host.$application.*  

>>  Add panel:  
>>  items语法:  
>>>    /CPU/  # 代表所有cpu的值  
>>>    /: (.*) space/  # 代表开头为: 结尾space的所有值  
>>>    如果单位显示有误，需要调整y轴单位Unit  

>>  批量添加流量图：  
>>>    有时候我们需要将所有的流量图都放到一个dashboard中，手动添加太繁琐，可以通过json文件添加  
>>>>	1、先添加2个模板图  
>>>>	2、复制json文件编辑，添加节点（http://www.bejson.com/jsoneditoronline/）  
>>>>	3、需要改的字段如下(版本不同可能字段不同，需要先观察)：  
>>>>>		panels下复制一个节点，0,1,2  
>>>>>		gridPos(决定图的位置)  
>>>>>		targets(修改组，主机，键值)  
>>>>>		title(标题头)  
